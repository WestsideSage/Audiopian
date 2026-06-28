# UX Redesign — Phase 3: Word-by-Word Fill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the discrete grey→green/amber/red *snap* on each lyric word with a **progressive left-to-right color sweep** that fills each word as its predicted timing window passes, driven off the existing `scoring.js` `interpolateWordTimings` word timings + the playback clock. The sweep is a **pure visual overlay**: it changes only *how* a word looks while its window is passing — it never changes what the scorer credits, never changes the `.matched`/`.matched-partial`/`.missed` classes the scoring path applies, and is verified green against every existing scoring test.

**Architecture:** A new pure helper `static/word-fill-helpers.js` (`window.KaraokeeWordFill`) computes a per-word fill fraction `0..1` from `{start, end}` (seconds) + the current clock. `player.js` adds a **render-only** `requestAnimationFrame` paint loop (`_startWordFillLoop` / `_stopWordFillLoop` / `_paintWordFill`) that, for the **active line only**, maps each live word-timing object from `this.allWordTimings[activeLineIdx]` (fields `windowStart` / `windowEnd`, in seconds — confirmed in `scoring.js`) onto `{start, end}`, calls the helper, and writes the resulting fraction onto each `.word-span` as a CSS custom property `--fill`. `style.css` renders `--fill` as a left-to-right gradient/`background-clip:text` sweep on **unresolved** spans (no `.matched`/`.matched-partial`/`.missed` class yet); the moment the scorer resolves a span, the existing class wins and the sweep is irrelevant. The loop reads only render/clock state (`playback.currentTime()`, the DOM spans, `this.allWordTimings`) — it touches **no** `matchedSet`, no session, no scoring decision. `prefers-reduced-motion` ⇒ the loop is not started (words keep today's discrete snap).

**Tech Stack:** Plain HTML/CSS/JS (no build step), UMD helper pattern (`new Function`-loadable for `.cjs` tests), Flask static serving (`python app.py` → http://localhost:5000), Node for JS tests.

**Spec:** `docs/superpowers/specs/2026-06-28-ux-redesign-design.md` §3.4 (the word-by-word fill bullet) + §4 (testing/isolation: "prove the fill is a pure overlay on the existing paint and does not change what the scorer credits"). Branch: `feat/ux-geist-redesign`.

**Depends on:** Phase 2 (scoring feedback & on-fire — establishes the score-feedback/beat-pulse render layer and the unified score panel) **and** the parallel `word-fill-helpers.js` plan (which builds `static/word-fill-helpers.js` + `tests/test_word_fill_helpers.cjs`). **This plan re-states the helper contract and its test (Task 1) so it is self-contained**: if the parallel plan already landed the helper, Task 1's impl step is a no-op (the file already matches) and you only confirm the test passes; if it has not, Task 1 builds it. Either way the helper API consumed here is exactly the canonical one below.

**Phase 3 boundaries (read before starting):**
- **HONESTY GUARD (non-negotiable):** the fill is cosmetic. It must not read or mutate any scoring state (`matchedSet`, `vadMatchedSet`, `asrConfirmedSet`, the session, the phrase engine). It must not add/remove the `.matched`, `.matched-partial`, `.missed`, or `.key-word` classes. Every existing scoring `.cjs` test stays byte-for-byte green, and the visual sweep is suppressed the instant a real scoring class lands on a span.
- The scoring logic files (`scoring-arcade.js`, `scoring-session.js`, `scoring.js`, `phrase-engine.js`) are **frozen** — not edited in this phase. `scoring.js` is *read* (to confirm word-timing field names) but never changed.
- The fill paints the **active line only**. Past/future lines keep their current rendering. This keeps the rAF loop cheap and avoids fighting the scroll.
- `player.js` is the only DOM-bound file touched. All new pure logic lands in `word-fill-helpers.js` with a `.cjs` test.
- `prefers-reduced-motion: reduce` ⇒ no sweep (the loop never starts); the discrete snap from prior phases is the reduced-motion fallback.

---

## Task 1: `word-fill-helpers.js` — pure per-word fill progress (TDD)

**Files:**
- Create: `static/word-fill-helpers.js`
- Test: `tests/test_word_fill_helpers.cjs`

> **Note (Windows + backticks):** `word-fill-helpers.js` contains **no** backtick template literals, so it is safe to create with the Write/Edit tool normally. (If you ever add a template literal to a JS file on Windows, write it with the Write/Edit tool, never a shell heredoc — heredocs strip backtick contents on this machine.)

> If the parallel `word-fill-helpers` plan already created this file and test, run Step 2's command first: if it already PASSES, the file is correct — skip Steps 1/3 and go straight to Step 5 (commit is then unnecessary; note "already present" and move to Task 2). Otherwise implement as written below.

- [ ] **Step 1: Write the failing test**

Create `tests/test_word_fill_helpers.cjs` (mirrors the loader pattern in `tests/test_browser_support.cjs`):

```js
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

// Load word-fill-helpers.js as a plain script (simulates browser <script> loading).
// Parent package.json is "type": "module", so require() would treat .js as ESM.
var filePath = path.join(__dirname, '..', 'static', 'word-fill-helpers.js');
var code = fs.readFileSync(filePath, 'utf8');
var fakeModule = { exports: {} };
new Function('module', 'exports', code)(fakeModule, fakeModule.exports);
var W = fakeModule.exports;

function approx(actual, expected, msg) {
    assert.ok(Math.abs(actual - expected) < 1e-9, msg + ' (got ' + actual + ', want ' + expected + ')');
}

// ── wordFillProgress: linear ramp from start..end (seconds) ──
var w = { start: 2.0, end: 4.0 };
assert.strictEqual(W.wordFillProgress(w, 1.0), 0, 'before start -> 0');
assert.strictEqual(W.wordFillProgress(w, 2.0), 0, 'at start -> 0');
approx(W.wordFillProgress(w, 3.0), 0.5, 'midpoint -> 0.5');
approx(W.wordFillProgress(w, 2.5), 0.25, 'quarter -> 0.25');
assert.strictEqual(W.wordFillProgress(w, 4.0), 1, 'at end -> 1');
assert.strictEqual(W.wordFillProgress(w, 9.0), 1, 'after end -> 1 (clamped)');

// ── zero / negative duration -> step function (no divide-by-zero) ──
var z = { start: 5.0, end: 5.0 };
assert.strictEqual(W.wordFillProgress(z, 4.9), 0, 'zero-dur before -> 0');
assert.strictEqual(W.wordFillProgress(z, 5.0), 1, 'zero-dur at -> 1');
assert.strictEqual(W.wordFillProgress(z, 5.1), 1, 'zero-dur after -> 1');
var neg = { start: 6.0, end: 5.0 };
assert.strictEqual(W.wordFillProgress(neg, 5.9, 'neg-dur before start -> 0'), 0);
assert.strictEqual(W.wordFillProgress(neg, 6.0), 1, 'neg-dur at start -> 1');

// ── result always clamped to [0,1] ──
assert.ok(W.wordFillProgress(w, -100) >= 0, 'far-before clamped >= 0');
assert.ok(W.wordFillProgress(w, 1e6) <= 1, 'far-after clamped <= 1');

// ── lineFillProgress: maps each word; [] -> [] ──
assert.deepStrictEqual(W.lineFillProgress([], 3.0), [], 'empty line -> []');
var line = [
    { start: 0.0, end: 2.0 },
    { start: 2.0, end: 4.0 },
    { start: 4.0, end: 6.0 }
];
var prog = W.lineFillProgress(line, 3.0);
assert.strictEqual(prog.length, 3, 'one entry per word');
assert.strictEqual(prog[0], 1, 'word 0 fully past -> 1');
approx(prog[1], 0.5, 'word 1 halfway -> 0.5');
assert.strictEqual(prog[2], 0, 'word 2 not started -> 0');

console.log('All word-fill-helpers tests passed.');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/test_word_fill_helpers.cjs`
Expected: FAIL — `ENOENT` (file `static/word-fill-helpers.js` does not exist) — *unless* the parallel plan already landed it, in which case it PASSES (see the note above and skip to Task 2).

- [ ] **Step 3: Write the minimal implementation**

Create `static/word-fill-helpers.js`:

```js
/**
 * Pure per-word fill-progress helpers for the word-by-word lyric sweep.
 * No DOM, no clock of its own — the caller passes a {start, end} word (seconds)
 * and the current time, so it is fully testable in Node.js. Browser pages also
 * get window.KaraokeeWordFill.
 *
 * Strictly cosmetic: this computes "how far through this word's timing window are
 * we" (0..1). It has no knowledge of, and no effect on, scoring.
 */
(function (root) {
    'use strict';

    function clamp01(x) {
        if (!(x > 0)) return 0;      // also catches NaN / -0 / negatives
        if (x > 1) return 1;
        return x;
    }

    /**
     * Fraction (0..1) through a word's timing window at nowSec.
     * @param {{start:number, end:number}} word  start/end in SECONDS.
     * @param {number} nowSec                     current clock in SECONDS.
     * @returns {number} 0 before start, 1 at/after end, linear between.
     *                   end<=start (zero/negative duration) -> step (0 before start, 1 at/after).
     */
    function wordFillProgress(word, nowSec) {
        if (!word) return 0;
        var start = word.start;
        var end = word.end;
        if (typeof start !== 'number' || typeof end !== 'number') return 0;
        if (end <= start) return nowSec < start ? 0 : 1;  // zero/neg duration: step (must precede <=start guard)
        if (nowSec <= start) return 0;
        if (nowSec >= end) return 1;
        return clamp01((nowSec - start) / (end - start));
    }

    /**
     * Map an array of {start,end} words to their fill fractions at nowSec.
     * @param {Array<{start:number,end:number}>} words
     * @param {number} nowSec
     * @returns {Array<number>} one 0..1 entry per word ([] -> []).
     */
    function lineFillProgress(words, nowSec) {
        if (!words || !words.length) return [];
        var out = new Array(words.length);
        for (var i = 0; i < words.length; i++) {
            out[i] = wordFillProgress(words[i], nowSec);
        }
        return out;
    }

    var api = {
        wordFillProgress: wordFillProgress,
        lineFillProgress: lineFillProgress
    };
    if (root) root.KaraokeeWordFill = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/test_word_fill_helpers.cjs`
Expected: PASS — `All word-fill-helpers tests passed.`

- [ ] **Step 5: Commit**

```bash
git add static/word-fill-helpers.js tests/test_word_fill_helpers.cjs
git commit -m "feat(word-fill): add pure per-word fill-progress helpers + tests"
```

---

## Task 2: Load `word-fill-helpers.js` in the player + confirm script order

**Files:**
- Modify: `static/player.html` (`<head>`/script-loading region — load `word-fill-helpers.js` alongside the other helper `<script>`s)

The helper must be a `window.KaraokeeWordFill` global before `player.js` runs. It has no dependencies, so it can load in any order relative to the other helpers, but it must load **before** `player.js`.

- [ ] **Step 1: Locate the helper script includes**

Open `static/player.html` and find the block of `<script src="/static/…-helpers.js">` (and other `static/*.js`) includes that precedes `<script src="/static/player.js">`. Use the existing `lyric-paint-helpers.js` include as the stable anchor:

Run: `grep -n "lyric-paint-helpers.js\|scoring.js\|player.js" static/player.html`
Expected: lines showing the helper includes and the `player.js` include near the end of `<body>`.

- [ ] **Step 2: Add the include**

In `static/player.html`, immediately after the existing
`<script src="/static/lyric-paint-helpers.js"></script>` line, insert:

```html
    <script src="/static/word-fill-helpers.js"></script>
```

(If `lyric-paint-helpers.js` is not present as an exact line, insert the include anywhere in the same helper-script group, as long as it is **before** the `<script src="/static/player.js">` line.)

- [ ] **Step 3: Verify the global is available**

Run: `python app.py` then open http://localhost:5000/player (load any song via search, or use the local-upload dev path).
In DevTools console:

```js
typeof window.KaraokeeWordFill
window.KaraokeeWordFill.wordFillProgress({ start: 0, end: 2 }, 1)
```

Expected: `'object'` and `0.5`. No console errors on load.

- [ ] **Step 4: Run the JS + Python suites (regression guard)**

```bash
node tests/test_word_fill_helpers.cjs
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add static/player.html
git commit -m "feat(word-fill): load word-fill-helpers global in the player"
```

---

## Task 3: CSS — render `--fill` as a left-to-right sweep on unresolved word spans

**Files:**
- Modify: the player word-span CSS. In Phase 0 this block was extracted from `player.html`'s inline `<style>` into `static/style.css` under the "Player page" section. **Locate it by the stable selector `.word-span`** (Phase 1 remapped its color to `var(--text-faint)`, so match the selector, not a color literal), wherever it now lives (`static/style.css` if Phase 0 landed; otherwise the inline `<style>` in `player.html`). Edit it in its current home.

This adds the gradient sweep **without touching** the existing `.matched` / `.matched-partial` / `.missed` rules, and scopes it so it only applies to spans that the scorer has **not** resolved yet. The sweep is keyed off a `--fill` custom property (default 0) and a base/fill color pair.

- [ ] **Step 1: Add the fill-color tokens to the player word-span base rule**

Find the `.word-span` base rule (anchor: `display: inline-block;` + `color: var(--text-faint);`):

```css
        .word-span {
            display: inline-block;
            color: var(--text-faint);
            transition: color 0.15s, text-shadow 0.15s;
            cursor: default;
        }
```

Replace it with (adds a `--fill` default and a local fill-color var; keeps the existing color/transition so resolved/un-swept spans look identical to today):

```css
        .word-span {
            display: inline-block;
            color: var(--text-faint);
            /* Progressive fill: 0..1 written per-frame by player.js _paintWordFill.
               Default 0 so a span with no fill paints exactly as before. */
            --fill: 0;
            /* The color the sweep reveals as a word's window passes (cyan key cue
               for key words is overridden below; non-key words sweep to text white). */
            --fill-color: var(--text);
            transition: color 0.15s, text-shadow 0.15s;
            cursor: default;
        }
```

- [ ] **Step 2: Add the sweep rule for unresolved spans on the active line**

Immediately **after** the `.lyric-line.active .word-span.key-word:not(.matched):not(.matched-partial):not(.missed)` rule (anchor: `text-shadow: 0 0 12px rgba(45,212,238,.45);`), insert:

```css
        /* ── Word-by-word fill (Phase 3) ──────────────────────────────
           A left-to-right color sweep across each word on the ACTIVE line
           while its timing window passes. Purely cosmetic: it applies ONLY
           to spans the scorer has NOT resolved (no .matched/.matched-partial/
           .missed). The instant a real scoring class lands, that rule's color
           wins and the sweep is moot. --fill (0..1) is written per-frame by
           player.js; key words sweep to the cyan cue, others to text white.   */
        .lyric-line.active .word-span:not(.matched):not(.matched-partial):not(.missed) {
            background-image: linear-gradient(
                90deg,
                var(--fill-color) 0%,
                var(--fill-color) calc(var(--fill) * 100%),
                transparent calc(var(--fill) * 100%),
                transparent 100%
            );
            -webkit-background-clip: text;
            background-clip: text;
            /* The unfilled remainder keeps the base grey via the element color
               (background-clip:text reveals the gradient only where it's opaque). */
            -webkit-text-fill-color: transparent;
        }
        /* Key words sweep to the cyan key cue instead of plain text white. */
        .lyric-line.active .word-span.key-word:not(.matched):not(.matched-partial):not(.missed) {
            --fill-color: var(--key);
        }
```

> **Why `:not(.matched):not(.matched-partial):not(.missed)`:** the sweep is suppressed the moment the scorer resolves a span. The existing `.matched`/`.matched-partial`/`.missed` rules set a plain `color:` and do not set `-webkit-text-fill-color`, so once one lands it fully governs the span's color and the gradient is never seen — the honesty guard at the CSS layer.

> **`background-clip:text` + `text-fill-color: transparent` caveat:** with `text-fill-color: transparent`, the *unfilled* portion of a word would also go transparent. To keep the unfilled remainder readable in the base grey, the gradient's "transparent" stops are replaced below in Step 3's correction — **do Step 3, do not stop here.**

- [ ] **Step 3: Correct the sweep so the unfilled remainder stays grey (not invisible)**

`background-clip:text` paints text from the gradient; `transparent` stops would hide the not-yet-filled letters. Replace the rule you just added in Step 2 with this version, which sweeps from `--fill-color` to the base grey `var(--text-faint)` (so the word is always fully legible, the front portion just turns the fill color):

```css
        /* ── Word-by-word fill (Phase 3) ──────────────────────────────
           A left-to-right color sweep across each word on the ACTIVE line
           while its timing window passes. Purely cosmetic: applies ONLY to
           spans the scorer has NOT resolved (no .matched/.matched-partial/
           .missed). The instant a real scoring class lands, that rule's
           plain color: wins and the sweep is moot. --fill (0..1) is written
           per-frame by player.js; the filled head is --fill-color, the tail
           stays the base grey so the whole word is always legible.            */
        .lyric-line.active .word-span:not(.matched):not(.matched-partial):not(.missed) {
            background-image: linear-gradient(
                90deg,
                var(--fill-color) 0%,
                var(--fill-color) calc(var(--fill) * 100%),
                var(--text-faint) calc(var(--fill) * 100%),
                var(--text-faint) 100%
            );
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            color: transparent;
        }
        /* Key words sweep to the cyan key cue instead of plain text white. */
        .lyric-line.active .word-span.key-word:not(.matched):not(.matched-partial):not(.missed) {
            --fill-color: var(--key);
        }
```

> Note: with `--fill: 0` (the default for any span the loop hasn't painted, e.g. on a non-reduced-motion machine before the rAF loop touches a span), the gradient is `var(--text-faint)` across the whole word — visually identical to today's grey. So even an un-painted active line looks unchanged.

- [ ] **Step 4: Preview-verify the sweep mechanically (before wiring the loop)**

Run: `python app.py` then open http://localhost:5000/player and load a song into a **scored** game (any difficulty). Pause near the start so a line is active but the scorer hasn't resolved its spans.
In DevTools console, manually drive the property on the active line's first span to confirm the CSS works:

```js
var s = document.querySelector('.lyric-line.active .word-span');
s.style.setProperty('--fill', '0');   // whole word base grey
s.style.setProperty('--fill', '0.5'); // left half cyan/white, right half grey
s.style.setProperty('--fill', '1');   // whole word fill color
```

Expected: the word's left-to-right portion fills as you raise `--fill`; the tail stays grey; the word is always fully legible. Resolved spans (`.matched` etc.) are unaffected.

- [ ] **Step 5: Run the suites (CSS can't break them, but confirm)**

```bash
node tests/test_word_fill_helpers.cjs
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add static/style.css static/player.html
git commit -m "feat(word-fill): add per-word fill sweep CSS on unresolved active-line spans"
```

---

## Task 4: `player.js` — map active-line word timings onto `{start,end}` (render-only adapter)

**Files:**
- Modify: `static/player.js` (add a small render-only helper method on the game-mode class; **no** edits to any scoring method)

This task adds **only** the adapter that turns the active line's `this.allWordTimings[lineIdx]` word objects (fields `windowStart` / `windowEnd`, in seconds — confirmed in `scoring.js` `interpolateWordTimings`) into the `{start, end}` shape the pure helper expects. It does not yet paint — that's Task 5. Keeping the mapping in its own method makes the data contract explicit and keeps the paint loop readable.

> **Field-name confirmation (do this first):** open `static/scoring.js`, find `function interpolateWordTimings`, and confirm each per-word `timing` object has `windowStart` and `windowEnd` (seconds). It does (the object literal sets `windowStart: wStart` and `windowEnd: estimatedTime + params.windowEnd`). If a future refactor renamed these, update the mapping below to match — but **do not** change `scoring.js`.

- [ ] **Step 1: Add the `_activeLineFillWords` adapter method**

In `static/player.js`, locate the render-only paint helpers on the game-mode class — the stable anchor is the method `_paintAnchorSpansLive(lineEl) {` (the V2 anchor-span painter). Immediately **before** that method, insert:

```js
    // Render-only adapter (Phase 3 word-fill): turn the active line's interpolated
    // word timings (scoring.js interpolateWordTimings -> windowStart/windowEnd, SECONDS)
    // into the pure {start, end} shape KaraokeeWordFill expects. Reads render/clock
    // state ONLY (this.allWordTimings + the line index) — touches no scoring state.
    // Returns [] when there is no active line or no timings (caller paints nothing).
    _activeLineFillWords(lineIdx) {
        var timings = (lineIdx != null && lineIdx >= 0 && this.allWordTimings &&
            lineIdx < this.allWordTimings.length) ? this.allWordTimings[lineIdx] : null;
        if (!timings || !timings.length) return [];
        var out = new Array(timings.length);
        for (var i = 0; i < timings.length; i++) {
            var wt = timings[i];
            // estimatedTime/windowStart/windowEnd are all in SECONDS; windowStart can be
            // slightly before estimatedTime (lead-in), windowEnd after. Use the window so
            // the sweep matches the scorer's own predicted timing band exactly.
            out[i] = { start: wt.windowStart, end: wt.windowEnd };
        }
        return out;
    }
```

- [ ] **Step 2: Verify it parses and returns the right shape**

Run: `python app.py` then open http://localhost:5000/player, load a song into a scored game, let it reach the first lyric line, then in DevTools console:

```js
gameMode._activeLineFillWords(gameMode.activeLineIdx)
```

Expected: an array of `{start, end}` objects (numbers, in seconds) — one per word of the active line — or `[]` if no line is active yet. No errors.

- [ ] **Step 3: Run the suites (regression guard)**

```bash
node tests/test_word_fill_helpers.cjs
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: all PASS (this method is render-only and unreferenced by scoring).

- [ ] **Step 4: Commit**

```bash
git add static/player.js
git commit -m "feat(word-fill): add render-only active-line {start,end} adapter in player"
```

---

## Task 5: `player.js` — the rAF fill paint loop (reduced-motion gated, render-only)

**Files:**
- Modify: `static/player.js` (add `_startWordFillLoop` / `_stopWordFillLoop` / `_paintWordFill` methods; start the loop on game start, stop it on stop/end)

The paint loop runs at animation framerate (smoother than the 100ms scoring tick), reads the playback clock + the active line's DOM spans, and writes `--fill` per span. It is **gated off** when `prefers-reduced-motion: reduce` (the discrete snap then remains the reduced-motion fallback). It writes nothing but the `--fill` custom property on `.word-span` elements and never reads or writes scoring state.

> **This task's code contains a `requestAnimationFrame` callback only — no backtick template literals — so it is safe to add with the Edit tool normally.**

- [ ] **Step 1: Add the loop methods**

In `static/player.js`, immediately **after** the `_activeLineFillWords(lineIdx) { … }` method added in Task 4, insert:

```js
    // Phase 3 word-fill paint loop. Render-only: reads the playback clock + the
    // active line's spans and writes the per-word --fill custom property so CSS
    // sweeps each unresolved word left-to-right as its window passes. Touches NO
    // scoring state (no matchedSet/session/phrase engine), adds/removes NO scoring
    // classes. Gated off under prefers-reduced-motion (discrete snap stays the
    // fallback). Cheap: paints only the active line's spans, once per frame.
    _startWordFillLoop() {
        if (this._wordFillRaf != null) return;            // already running
        if (typeof window === 'undefined' || !window.requestAnimationFrame) return;
        if (!window.KaraokeeWordFill) return;             // helper missing -> no-op
        // Respect reduced-motion: do not sweep; today's discrete snap remains.
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        var self = this;
        var step = function () {
            self._paintWordFill();
            self._wordFillRaf = window.requestAnimationFrame(step);
        };
        this._wordFillRaf = window.requestAnimationFrame(step);
    }

    _stopWordFillLoop() {
        if (this._wordFillRaf != null && typeof window !== 'undefined' && window.cancelAnimationFrame) {
            window.cancelAnimationFrame(this._wordFillRaf);
        }
        this._wordFillRaf = null;
    }

    // One frame of fill paint. Active line only; unresolved spans only.
    _paintWordFill() {
        if (!window.KaraokeeWordFill) return;
        var lineIdx = this.activeLineIdx;
        if (lineIdx == null || lineIdx < 0) return;
        var lines = lyricsScroll.querySelectorAll('.lyric-line');
        var lineEl = lines[lineIdx];
        if (!lineEl) return;
        var words = this._activeLineFillWords(lineIdx);   // [{start,end}, ...]
        if (!words.length) return;
        var nowSec = playback ? playback.currentTime() : 0;
        var fills = window.KaraokeeWordFill.lineFillProgress(words, nowSec);
        var spans = lineEl.querySelectorAll('.word-span');
        // The DOM span list and the timing list are *usually* the same word
        // sequence, but can drift if a token normalizes to empty (renderLyrics-
        // GameMode drops normalizeWord().length===0 tokens; interpolateWordTimings
        // keeps every token). Math.min below bounds the pairing, and the sweep is
        // render-only, so any drift is cosmetic — never a scoring effect.
        var n = Math.min(spans.length, fills.length);
        for (var i = 0; i < n; i++) {
            var span = spans[i];
            // Skip resolved spans: once the scorer has painted a class, the CSS
            // :not(.matched)... guard already disables the sweep, but skipping the
            // write avoids needless style churn (and is the honesty guard in JS too).
            if (span.classList.contains('matched') ||
                span.classList.contains('matched-partial') ||
                span.classList.contains('missed')) {
                continue;
            }
            span.style.setProperty('--fill', String(fills[i]));
        }
    }
```

- [ ] **Step 2: Start the loop when a scored game starts**

In `static/player.js`, find the game-mode `start()` method (the per-run setup — anchor: it builds `this.allWordTimings = interpolateWordTimings(lyrics);` near the top of the method). At the **end** of `start()`, after the existing setup completes, add the loop start. Use a stable anchor: locate the last statement of `start()` and append:

```js
        this._startWordFillLoop();
```

(If `start()` ends by kicking off capture/recognition, place `this._startWordFillLoop();` as the final line of the method body, before its closing `}`.)

- [ ] **Step 3: Stop the loop on stop and on end-of-run**

In `static/player.js`, find the methods that tear down a run. The stable anchors are the `stop()` method and the end-of-run path that calls `KaraokeeScoringSession.endRun`. In each teardown path, add:

```js
        this._stopWordFillLoop();
```

Specifically:
- In `stop()` (the game-mode stop/teardown method), add `this._stopWordFillLoop();` near where it pauses playback / tears down capture.
- In the end-of-run handler (the method that runs `this._renderEvents(KaraokeeScoringSession.endRun(this._session, this._now()));` — anchor on `endRun`), add `this._stopWordFillLoop();` after that line.

> Stopping the loop in both paths prevents a leaked rAF after the song ends or the user stops. The `_wordFillRaf` guard in `_startWordFillLoop` makes a re-start idempotent.

- [ ] **Step 4: Reset `--fill` on the new active line so a sweep never carries over**

When a new line becomes active, its spans are already reset to grey by the existing `_resetLineSpans(lineIdx)` (it clears the scoring classes). Extend that **render-only** reset to also clear `--fill`, so a line re-activated (e.g. on seek) starts from an empty sweep. Locate `_resetLineSpans(lineIdx) {` and its `querySelectorAll('.word-span').forEach` body (anchor: `s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');`). Replace that forEach body:

```js
            lines[lineIdx].querySelectorAll('.word-span').forEach(function (s) {
                s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');
            });
```

with:

```js
            lines[lineIdx].querySelectorAll('.word-span').forEach(function (s) {
                s.classList.remove('matched', 'matched-partial', 'missed', 'asr-confirmed');
                s.style.removeProperty('--fill');   // Phase 3: clear any prior sweep (render-only)
            });
```

> This only removes a cosmetic custom property. It does not touch the scoring classes' removal (which is the existing behavior) and adds nothing.

- [ ] **Step 5: Preview-verify the live sweep**

Run: `python app.py` then open http://localhost:5000/player, load a song, and play a scored game with mic. Watch the **active** line.
Expected:
- Each word fills left-to-right (grey → cyan for key words / white for others) as its timing window passes, ahead of/independent of whether you sing it.
- The instant the scorer resolves a word, it snaps to green/amber/red (the sweep stops mattering on that span).
- No flicker, no layout shift, no console errors. CPU stays reasonable (one rAF, active line only).

Then enable OS "Reduce motion" and reload into a game:
Expected: **no** sweep — words keep the original discrete grey→colored snap. Confirm in console:

```js
gameMode._wordFillRaf   // undefined/null under reduced motion (loop never started)
```

- [ ] **Step 6: Run the full suites**

```bash
node tests/test_word_fill_helpers.cjs
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add static/player.js
git commit -m "feat(word-fill): rAF fill paint loop (active line, reduced-motion gated, render-only)"
```

---

## Task 6: HONESTY GUARD — prove the fill does not change scoring

**Files:** none (verification only — this task ships **no** code; it is the gate the spec §4 requires)

This task is the explicit "prove the fill is a pure overlay" verification. It must pass before Phase 3 is considered done.

- [ ] **Step 1: Every scoring `.cjs` test stays green**

Run the full JS helper suite (the scoring-critical ones plus the new word-fill test):

```bash
node tests/test_scoring.cjs
node tests/test_scoring_session.cjs
node tests/test_scoring_arcade.cjs
node tests/test_phrase_engine.cjs
node tests/test_phrase_score.cjs
node tests/test_match_helpers.cjs
node tests/test_sync_helpers.cjs
node tests/test_word_fill_helpers.cjs
```

Expected: each prints its "All … tests passed." line. **No scoring test was edited and none fails** — confirming the scoring path is byte-for-byte unchanged.

- [ ] **Step 2: Static audit — the fill code reads no scoring state**

Confirm the Phase-3 player code never references scoring state. Run:

```bash
grep -n "_paintWordFill\|_startWordFillLoop\|_stopWordFillLoop\|_activeLineFillWords\|_wordFillRaf" static/player.js
```

Read each hit and verify the bodies reference **only**: `playback.currentTime()`, `this.activeLineIdx`, `this.allWordTimings`, `lyricsScroll`/`.lyric-line`/`.word-span` DOM, `window.KaraokeeWordFill`, `requestAnimationFrame`/`cancelAnimationFrame`/`matchMedia`, and the `--fill` style property.

They must **not** reference: `matchedSet`, `vadMatchedSet`, `asrConfirmedSet`, `this._session`, `KaraokeeScoringSession`, `_phraseSession`, `phraseEngine`, `KaraokeeArcade`, or add/remove any of `matched` / `matched-partial` / `missed` / `key-word` classes.

Run, and confirm **no output** (the fill code never writes a scoring class):

```bash
grep -nE "classList\.(add|remove)\(.*(matched|missed|key-word)" static/player.js | grep -iE "wordfill|_paintWordFill|fillLoop"
```

Expected: no output (the scoring-class writes live only in the pre-existing `_paint*`/`_resetLineSpans` painters, not in the fill loop).

- [ ] **Step 3: Behavioral honesty check — silent run is unaffected**

Run: `python app.py`, open http://localhost:5000/player, start a scored game, and **stay silent** through several lines while watching the score panel.
Expected: words still **sweep** their fill (the sweep is timing-driven, not sing-driven) but the **score does not move** and the scorer still marks unsung key words `.missed` (red) at settle — exactly as before Phase 3. The sweep is visibly cosmetic: a swept-but-unsung word ends red, not green.

- [ ] **Step 4: Behavioral honesty check — the score equals a pre-Phase-3 run**

Sing one full song the same way with the fill on, then compare the end-screen **points + accuracy %** against expectation: the numbers depend only on the (frozen) scorer, so they must be in the same range as before the fill existed. Spot-confirm in the saved telemetry that the `summary` block is unchanged in shape:

Run: open the newest file under `output_telemetry/<date>/` and confirm `meta.schemaVersion: 2` and the `summary`/`arcade` blocks are present and well-formed (the fill added no telemetry).

Expected: telemetry schema and score semantics unchanged; the fill left no trace in the scored output.

- [ ] **Step 5: No commit (verification-only task)**

This task ships no code. If any check fails, fix the offending Task (most likely Task 5's loop touched scoring state) and re-run — do not proceed until all five checks pass.

---

## Task 7: Phase 3 integration verification

**Files:** none (verification only)

- [ ] **Step 1: Run every JS `.cjs` test**

```bash
for f in tests/*.cjs; do echo "== $f =="; node "$f" || break; done
```

Expected: every file prints its "All … tests passed." line; no failures (including the new `test_word_fill_helpers.cjs`).

- [ ] **Step 2: Run the Python suite**

```bash
python -m pytest tests/test_app.py tests/test_downloader.py tests/test_lyrics.py -q
```

Expected: PASS.

- [ ] **Step 3: Manual sweep matrix (preview)**

Run: `python app.py`, http://localhost:5000/player, scored game:
- **Normal motion:** active line words sweep left-to-right as their windows pass; resolved words snap to green/amber/red and stop sweeping; past/future lines render as before; no layout shift, no console errors.
- **Reduced motion (OS setting on):** no sweep; discrete snap only; `gameMode._wordFillRaf` is null/undefined.
- **Seek backward** onto an already-active line: the sweep restarts cleanly (Task 5 Step 4 reset); no stale fill.
- **End of song / Stop:** the rAF loop is torn down (`gameMode._wordFillRaf` null afterward); no leaked animation frame.

- [ ] **Step 4: Confirm the branch state**

```bash
git log --oneline feat/ux-geist-redesign -7
git status
```

Expected: the new Phase-3 commits on `feat/ux-geist-redesign` (Task 1 helper [if not pre-landed], Task 2 include, Task 3 CSS, Task 4 adapter, Task 5 loop); clean working tree. Tasks 6 and 7 add no commits (verification only).

---

## Phase 3 done — what's shipped

Phase 3 delivers the progressive word-by-word fill: a pure `word-fill-helpers.js` (`wordFillProgress`/`lineFillProgress`, `.cjs`-tested), a reduced-motion-gated rAF paint loop in `player.js` that sweeps each **active-line** word left-to-right off the scorer's own `interpolateWordTimings` windows + the playback clock, and the CSS that renders the sweep **only on unresolved spans** so the existing `.matched`/`.matched-partial`/`.missed` paint always wins once the scorer decides. The honesty guard (Task 6) proves the fill changed nothing the scorer credits: every scoring test stays green, the fill code reads no scoring state, and a silent run still scores zero with red misses despite the cosmetic sweep.

This is the final phase of the UX redesign (`docs/superpowers/specs/2026-06-28-ux-redesign-design.md`). With Phase 0 (tokens/theme), Phase 1 (re-skin), Phase 2 (scoring feedback + on-fire), and Phase 3 (word-fill) complete, the redesign's render layer is fully on-brand and the scoring logic was never touched.
