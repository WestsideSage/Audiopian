# UX Redesign — `word-fill-helpers.js` Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, DOM-free `static/word-fill-helpers.js` (`window.KaraokeeWordFill`) helper — `wordFillProgress(word, nowSec)` and `lineFillProgress(words, nowSec)` — plus its full `.cjs` test, implementing the locked contract exactly. This is the timing math for the Phase-3 progressive word-by-word lyric fill (a left-to-right color sweep across each word as its timing window passes). The helper is consumed later by `player.js`; this plan ships **only** the tested pure helper.

**Architecture:** A single UMD helper module exposing two pure functions over `{start, end}` (both **seconds**) word objects. `wordFillProgress` returns a `0..1` fraction of how far the playhead has swept through one word; `lineFillProgress` maps an array of words to an array of those fractions. No DOM, no clock, no AudioContext — `nowSec` is injected, so everything is testable in Node via `node:assert`.

The eventual live consumer (a later Phase-3 task in `player.js`, **not** built here) maps each live word object produced by `static/scoring.js` `interpolateWordTimings` onto the `{start, end}` shape the helper expects. Confirmed against source, `interpolateWordTimings(lyricsArr)` returns, per line, an array of word-timing objects each shaped:

```js
{
  word: "<normalized>",       // string
  estimatedTime: <seconds>,   // float — start cursor for this word within the line
  windowStart:   <seconds>,   // float — earliest credit time (can be < estimatedTime)
  windowEnd:     <seconds>,   // float — latest credit time
  wordClass:     "<class>",
  weight:        <number>,
  phonetic:      [...]
}
```

All four time fields (`estimatedTime`, `windowStart`, `windowEnd`) are in **seconds** (derived from `line.time` LRC timestamps, which are seconds). The per-line array also carries `wps`, `tempoClass`, `lineStart`, `lineEnd` as array properties. The intended live mapping (documented here for the Phase-3 consumer, **not** implemented by this helper) is:

```js
// Future player.js consumer — illustrative, NOT part of this helper:
//   wordObj => ({ start: wordObj.estimatedTime, end: nextWord.estimatedTime })
// i.e. sweep each word from its own estimatedTime to the NEXT word's estimatedTime
// (the last word in a line ends at the line array's lineEnd property), so the fill
// reads as a continuous left-to-right wipe across the line. windowStart/windowEnd
// stay the SCORING window and are not used for the visual fill.
```

The helper itself stays purely `{start, end}` and knows nothing about `interpolateWordTimings` — that mapping is the consumer's job, keeping the helper trivially testable and the scoring path frozen.

**Tech Stack:** Plain JS, no build step. UMD helper pattern (`window.KaraokeeWordFill` in the browser; `module.exports` / `new Function`-loadable for the `.cjs` test). Node for the test; Flask static (`python app.py` → http://localhost:5000) only for a later wiring phase (not this plan).

**Depends on:** None — parallel-safe. This plan touches only two new files (`static/word-fill-helpers.js`, `tests/test_word_fill_helpers.cjs`) and does not modify `style.css`, `player.js`, any HTML, or any scoring module. It can run alongside the Phase 0 foundation plan and the other two helper plans (`beat-pulse-helpers`, `score-feedback-helpers`) without conflict.

---

## Locked contract (do not deviate)

From the redesign spec (§3.4) and the helper-API freeze:

- `wordFillProgress(word, nowSec)` — `word = {start: seconds, end: seconds}`:
  - `nowSec <= start` → `0`
  - `nowSec >= end` → `1`
  - between → linear, i.e. `(nowSec - start) / (end - start)`
  - `end <= start` (zero or negative duration) → **step**: `nowSec < start ? 0 : 1`
  - result clamped to `[0, 1]`
- `lineFillProgress(words, nowSec)` — `Array<0..1>`, each element = `wordFillProgress(words[i], nowSec)`; `[]` → `[]`.

Pure. No mutation of inputs. No DOM/clock/global reads.

---

## Task 1: `word-fill-helpers.js` + tests — `wordFillProgress` (TDD)

**Files:**
- Create: `static/word-fill-helpers.js`
- Create: `tests/test_word_fill_helpers.cjs`

This task builds the single-word function and a complete edge-case test for it. `lineFillProgress` is added in Task 2 (its tests are appended to the same file).

- [ ] **Step 1: Write the failing test for `wordFillProgress`**

Create `tests/test_word_fill_helpers.cjs` (mirrors the loader pattern in `tests/test_browser_support.cjs`: read the file, then `new Function('module','exports',code)`):

```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load word-fill-helpers.js as a plain script (simulates browser <script> loading).
// Parent package.json is "type": "module", so require() would treat .js as ESM.
var filePath = path.join(__dirname, '..', 'static', 'word-fill-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var m = { exports: {} };
new Function('module', 'exports', code)(m, m.exports);
var WF = m.exports;

assert.strictEqual(typeof WF.wordFillProgress, 'function', 'wordFillProgress is exported');

// --- wordFillProgress: a 2-second word from t=10 to t=12 -------------------
var w = { start: 10, end: 12 };

// Before start -> 0.
assert.strictEqual(WF.wordFillProgress(w, 9), 0, 'before start -> 0');
assert.strictEqual(WF.wordFillProgress(w, 0), 0, 'well before start -> 0');

// Exactly at start -> 0.
assert.strictEqual(WF.wordFillProgress(w, 10), 0, 'at start -> 0');

// Mid-word linearity.
assert.strictEqual(WF.wordFillProgress(w, 11), 0.5, 'halfway -> 0.5');
assert.strictEqual(WF.wordFillProgress(w, 10.5), 0.25, 'quarter -> 0.25');
assert.strictEqual(WF.wordFillProgress(w, 11.5), 0.75, 'three-quarter -> 0.75');

// Exactly at end -> 1.
assert.strictEqual(WF.wordFillProgress(w, 12), 1, 'at end -> 1');

// After end -> 1 (clamped, never overshoots).
assert.strictEqual(WF.wordFillProgress(w, 13), 1, 'after end -> 1');
assert.strictEqual(WF.wordFillProgress(w, 999), 1, 'well after end -> 1');

// --- zero-duration word (end === start) -> step function ------------------
var zero = { start: 5, end: 5 };
assert.strictEqual(WF.wordFillProgress(zero, 4.9), 0, 'zero-dur before -> 0');
assert.strictEqual(WF.wordFillProgress(zero, 5), 1, 'zero-dur at boundary -> 1 (nowSec >= start)');
assert.strictEqual(WF.wordFillProgress(zero, 5.1), 1, 'zero-dur after -> 1');

// --- negative-duration word (end < start) -> step function ----------------
var neg = { start: 8, end: 6 };
assert.strictEqual(WF.wordFillProgress(neg, 7.9), 0, 'neg-dur before start -> 0');
assert.strictEqual(WF.wordFillProgress(neg, 8), 1, 'neg-dur at start -> 1');
assert.strictEqual(WF.wordFillProgress(neg, 8.5), 1, 'neg-dur after start -> 1');

// --- result is always within [0, 1] ---------------------------------------
var samples = [-100, 9, 10, 10.7, 12, 50];
for (var i = 0; i < samples.length; i++) {
    var p = WF.wordFillProgress(w, samples[i]);
    assert.ok(p >= 0 && p <= 1, 'clamped to [0,1] at nowSec=' + samples[i] + ' got ' + p);
}

// --- does not mutate the input --------------------------------------------
var frozen = { start: 1, end: 3 };
WF.wordFillProgress(frozen, 2);
assert.deepStrictEqual(frozen, { start: 1, end: 3 }, 'input word is not mutated');

console.log('All word-fill-helpers tests passed.');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_word_fill_helpers.cjs`
Expected: **FAIL** — `ENOENT` reading `static/word-fill-helpers.js` (the file does not exist yet), surfaced as `Error: ENOENT: no such file or directory, open '.../static/word-fill-helpers.js'`.

- [ ] **Step 3: Write the minimal implementation (`wordFillProgress` only)**

> **Windows note:** this file contains no backtick template literals, but per the project rule, create/edit JS files with the Write/Edit tool directly — never via a Bash/shell heredoc.

Create `static/word-fill-helpers.js`:

```js
/**
 * Pure per-word fill-progress helpers for the progressive word-by-word lyric
 * sweep (Phase 3 of the UX redesign). DOM-free and clock-free: the caller
 * injects nowSec, so the timing math is testable in Node.js. Browser pages
 * also get window.KaraokeeWordFill.
 *
 * Contract — words are { start: seconds, end: seconds }:
 *   wordFillProgress(word, nowSec):
 *     nowSec <= start          -> 0
 *     nowSec >= end            -> 1
 *     between                  -> linear (nowSec - start) / (end - start)
 *     end <= start (0/neg dur) -> step (nowSec < start ? 0 : 1)
 *     result clamped to [0, 1]
 *   lineFillProgress(words, nowSec):
 *     Array<0..1> mapping each word through wordFillProgress; [] -> [].
 *
 * The live consumer (player.js, Phase 3) maps scoring.js interpolateWordTimings
 * word objects onto { start, end } in SECONDS before calling these; the helper
 * itself knows nothing about scoring and never touches the scoring path.
 */
(function (root) {
    'use strict';

    /**
     * @param {{start:number,end:number}} word  timing window in seconds.
     * @param {number} nowSec                    current playhead in seconds.
     * @returns {number} fill fraction in [0, 1].
     */
    function wordFillProgress(word, nowSec) {
        var start = word.start;
        var end = word.end;
        if (nowSec <= start) return 0;
        // Zero or negative duration: no ramp to interpolate -> step at start.
        if (end <= start) return 1;
        if (nowSec >= end) return 1;
        var p = (nowSec - start) / (end - start);
        if (p < 0) return 0;
        if (p > 1) return 1;
        return p;
    }

    var api = {
        wordFillProgress: wordFillProgress
    };
    if (root) root.KaraokeeWordFill = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_word_fill_helpers.cjs`
Expected: **PASS** — `All word-fill-helpers tests passed.`

- [ ] **Step 5: Commit**

```bash
git add static/word-fill-helpers.js tests/test_word_fill_helpers.cjs
git commit -m "feat(word-fill): add pure wordFillProgress helper + tests"
```

---

## Task 2: Add `lineFillProgress` (TDD)

**Files:**
- Modify: `static/word-fill-helpers.js` (add `lineFillProgress`, export it)
- Modify: `tests/test_word_fill_helpers.cjs` (append `lineFillProgress` cases before the final `console.log`)

- [ ] **Step 1: Write the failing test for `lineFillProgress`**

In `tests/test_word_fill_helpers.cjs`, insert the following block **immediately before** the final `console.log('All word-fill-helpers tests passed.');` line:

```js
// --- lineFillProgress ------------------------------------------------------
assert.strictEqual(typeof WF.lineFillProgress, 'function', 'lineFillProgress is exported');

// Empty array -> empty array.
assert.deepStrictEqual(WF.lineFillProgress([], 5), [], 'empty words -> []');

// A 3-word line; each word delegates to wordFillProgress.
var line = [
    { start: 0, end: 2 },   // word 0: [0,2]
    { start: 2, end: 4 },   // word 1: [2,4]
    { start: 4, end: 6 }    // word 2: [4,6]
];

// nowSec = 3 -> word0 fully filled (1), word1 halfway (0.5), word2 not started (0).
assert.deepStrictEqual(WF.lineFillProgress(line, 3), [1, 0.5, 0], 'mid-line: [1, 0.5, 0]');

// Before the whole line -> all zeros.
assert.deepStrictEqual(WF.lineFillProgress(line, -1), [0, 0, 0], 'before line -> all 0');

// After the whole line -> all ones.
assert.deepStrictEqual(WF.lineFillProgress(line, 100), [1, 1, 1], 'after line -> all 1');

// Result length always matches input length.
assert.strictEqual(WF.lineFillProgress(line, 3).length, line.length, 'length preserved');

// Single-word line.
assert.deepStrictEqual(WF.lineFillProgress([{ start: 10, end: 20 }], 15), [0.5], 'single word -> [0.5]');

// Mixed: a zero-duration word inside the line steps, neighbors interpolate.
var mixed = [
    { start: 0, end: 2 },   // halfway at t=1 -> 0.5
    { start: 2, end: 2 },   // zero-dur; at t=1 (< start) -> 0
    { start: 1, end: 5 }    // at t=1 (== start) -> 0
];
assert.deepStrictEqual(WF.lineFillProgress(mixed, 1), [0.5, 0, 0], 'mixed zero-dur line at t=1');

// Does not mutate the input array or its elements.
var src = [{ start: 1, end: 3 }, { start: 3, end: 5 }];
WF.lineFillProgress(src, 4);
assert.deepStrictEqual(src, [{ start: 1, end: 3 }, { start: 3, end: 5 }], 'input line not mutated');
```

- [ ] **Step 2: Run the test to verify the new cases fail**

Run: `node tests/test_word_fill_helpers.cjs`
Expected: **FAIL** — `lineFillProgress` is not yet exported, so the first new assertion trips: `AssertionError [ERR_ASSERTION]: lineFillProgress is exported` (actual `typeof` is `'undefined'`).

- [ ] **Step 3: Add the minimal `lineFillProgress` implementation**

In `static/word-fill-helpers.js`, replace this block:

```js
    var api = {
        wordFillProgress: wordFillProgress
    };
```

with:

```js
    /**
     * @param {Array<{start:number,end:number}>} words  per-word timing windows.
     * @param {number} nowSec                            current playhead in seconds.
     * @returns {Array<number>} per-word fill fractions in [0, 1]; [] for [].
     */
    function lineFillProgress(words, nowSec) {
        if (!words || words.length === 0) return [];
        var out = [];
        for (var i = 0; i < words.length; i++) {
            out.push(wordFillProgress(words[i], nowSec));
        }
        return out;
    }

    var api = {
        wordFillProgress: wordFillProgress,
        lineFillProgress: lineFillProgress
    };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_word_fill_helpers.cjs`
Expected: **PASS** — `All word-fill-helpers tests passed.`

- [ ] **Step 5: Commit**

```bash
git add static/word-fill-helpers.js tests/test_word_fill_helpers.cjs
git commit -m "feat(word-fill): add lineFillProgress over the word array + tests"
```

---

## Task 3: Regression guard + helper-isolation sanity

**Files:** none (verification only)

The helper is standalone, but confirm it loads cleanly as a browser-style global (not just `module.exports`) and that nothing else regressed.

- [ ] **Step 1: Verify the browser-global export path works**

Run:

```bash
node -e "global.window = {}; var fs=require('fs'); new Function('module','exports',fs.readFileSync('static/word-fill-helpers.js','utf8'))({exports:{}}, {}); console.log(typeof window.KaraokeeWordFill, typeof window.KaraokeeWordFill.wordFillProgress, typeof window.KaraokeeWordFill.lineFillProgress);"
```

Expected: `object function function` — confirming `window.KaraokeeWordFill` is populated when a `window` global exists (the browser `<script>` path), in addition to the `module.exports` path the `.cjs` test uses.

- [ ] **Step 2: Run the new test plus a couple of sibling helper tests (no shared state, but cheap insurance)**

```bash
node tests/test_word_fill_helpers.cjs
node tests/test_lyric_paint_helpers.cjs
node tests/test_scoring.cjs
```

Expected: each prints its `All … tests passed.` line; no failures. (`test_scoring.cjs` exercises `interpolateWordTimings`, confirming the field names this plan documented are still accurate; this plan made no changes to `scoring.js`, so it must stay green.)

- [ ] **Step 3: Confirm no stray edits leaked into frozen files**

```bash
git status --short
```

Expected: clean working tree (the two commits from Tasks 1–2 are already in). No modifications to `static/scoring.js`, `static/player.js`, `static/style.css`, or any HTML — this plan is helper-only.

---

## Done — what this delivers and what's next

This plan ships `static/word-fill-helpers.js` (`window.KaraokeeWordFill.wordFillProgress` / `.lineFillProgress`) with full edge-case coverage (before start, at start, mid-word linearity, at end, after end, zero-duration step, negative-duration step, clamping, empty array, mixed line, non-mutation) and a `.cjs` test that mirrors the project's helper-isolation pattern.

**Not in this plan (later Phase-3 wiring, separate work):**

- `player.js` mapping live `interpolateWordTimings` word objects → `{start, end}` seconds and calling `lineFillProgress` per animation frame to drive the progressive left-to-right color sweep.
- The CSS for the fill overlay (a gradient/clip sweep on the active lyric line), gated on `matchMedia('(prefers-reduced-motion: reduce)')` per the spec.
- Verification that the fill is a **pure visual overlay** that does not change what the scorer credits (the spec's explicit honesty gate for the highest-risk item).

Those steps consume this helper but do not modify it; the helper's pure `{start, end}` contract is the stable seam between them.
